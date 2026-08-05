import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Sidebar } from '@components/Sidebar'

const profileAccessState = vi.hoisted(() => ({
  approvalTargets: [] as Array<{ id: string }>,
  approvalTargetsError: false,
  approvalTargetsLoading: false,
  canManageMembers: false,
  manageableTeams: [],
  manageableTeamsError: false,
  manageableTeamsLoading: false,
  refreshApprovalTargets: vi.fn(),
  refreshManageableTeams: vi.fn(),
}))

vi.mock('next/image', () => ({
  default: ({ alt = '', ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} {...props} />
  ),
}))

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('@components/ProfileAccessContext', () => ({
  useProfileAccess: () => profileAccessState,
}))

beforeEach(() => {
  profileAccessState.approvalTargets = []
  profileAccessState.approvalTargetsError = false
  profileAccessState.approvalTargetsLoading = false
  profileAccessState.canManageMembers = false
  profileAccessState.manageableTeams = []
  profileAccessState.manageableTeamsError = false
  profileAccessState.manageableTeamsLoading = false
  profileAccessState.refreshApprovalTargets.mockClear()
  profileAccessState.refreshManageableTeams.mockClear()
})

afterEach(cleanup)

describe('Profile Sidebar access-controlled entries', () => {
  it('keeps the active approval-channel entry visible during a known-access refresh', () => {
    profileAccessState.approvalTargets = [{ id: 'slack-target' }]
    profileAccessState.approvalTargetsLoading = true

    const view = render(<Sidebar currentRoute="approvalChannels" onLogout={vi.fn()} />)

    const approvalLink = screen.getByRole('link', { name: /Approval Channels/i })
    expect(approvalLink).toHaveAttribute('aria-current', 'page')
    expect(approvalLink).toHaveAttribute('data-active', 'true')
    expect(view.container.querySelector('.cu-sidebar__item--loading')).not.toBeInTheDocument()
  })

  it('keeps initial approval-channel access unresolved behind a loading placeholder', () => {
    profileAccessState.approvalTargetsLoading = true

    const view = render(<Sidebar currentRoute="approvalChannels" onLogout={vi.fn()} />)

    expect(screen.queryByRole('link', { name: /Approval Channels/i })).not.toBeInTheDocument()
    expect(view.container.querySelector('.cu-sidebar__item--loading')).toBeInTheDocument()
  })
})
